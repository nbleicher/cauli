# Production readiness for the controlled Cauli pilot

## Problem Statement

Cauli’s core workflow works: invited Workspace Members can capture browser audio, process it into playable media and an English Transcript, organize Calls, and complete versioned Reviews. The product is not yet safe or operationally complete enough for a controlled production pilot. Important behavior is still missing or only partially enforced across Invitation Activation, MFA recovery, Workspace isolation, recording consent evidence, processing service levels, Review ownership and Follow-ups, mandatory retention, immutable auditing, Source Audio recovery, Platform Admin operations, release controls, accessibility, and incident response.

Without these controls, a pilot could lose Source Audio, retain customer content indefinitely, expose privileged operations without sufficient evidence, leave a Workspace Member locked out, silently exceed processing budgets, deploy untested code, or appear healthy while Calls are delayed. Cauli needs one explicit production boundary and an acceptance model that demonstrates the complete workflow rather than treating individual screens as production readiness.

## Solution

Prepare Cauli for an invite-only, U.S.-based pilot of no more than ten active Workspace Members across all production Workspaces. Preserve the existing Call capture, processing, playback, Transcript, Scorecard, and Review workflow while completing the security, governance, quality-assurance, disaster-recovery, operating, and release controls around it.

The finished pilot will require password creation during Invitation Activation, role-appropriate MFA, application-owned Recovery Codes, mandatory Recording Attestation, supported-browser enforcement, observable processing with budget controls, paginated Call discovery, assigned Reviews and tracked Follow-ups, mandatory Workspace Retention Policies, immutable Audit Events, independent encrypted Source Audio backups, and a separate Platform Admin control plane. Releases will be built from `main`, proven on an isolated staging stack, and promoted to production by immutable image digest. Legal, accessibility, security, backup-restore, and operational checks are release gates rather than post-launch aspirations.

## User Stories

1. As a prospective Workspace Member, I want access to begin only from a valid Workspace Invitation, so that Cauli remains invite-only.
2. As an invited person, I want the invitation link to prove control of my email address, so that I do not need a second email-verification step.
3. As an invited person, I want to create a password during Invitation Activation, so that my routine access does not depend on magic links.
4. As an invited person, I want Invitation Activation to remain incomplete until all required security factors are configured, so that I cannot enter the application in a partially secured state.
5. As an active Workspace Member, I want to sign in with my email address and password, so that routine login is predictable.
6. As a Workspace Member who forgot a password, I want a time-limited password-reset email, so that I can safely regain access.
7. As an Admin or Manager, I want TOTP MFA to be required, so that privileged access has a second factor.
8. As a Member Role Workspace Member, I want TOTP MFA to be optional, so that the pilot can balance security and operational simplicity for baseline access.
9. As a Workspace Member enrolling in MFA, I want ten single-use Recovery Codes displayed once with copy and download options, so that I can prepare for loss of my authenticator.
10. As a Workspace Member, I want each Recovery Code formatted clearly as `XXXX-XXXX-XXXX`, so that it can be stored and entered reliably.
11. As a Workspace Member who lost a TOTP factor, I want to use a Recovery Code only after proving my password, so that possession of a code alone cannot grant access.
12. As a Workspace Member using a Recovery Code, I want it to authorize only replacement of my inaccessible TOTP factor, so that it never acts as an MFA bypass into the application.
13. As a Workspace Member replacing a TOTP factor, I want access to remain blocked until the new factor is enrolled and verified, so that recovery ends in a secure state.
14. As a Workspace Member, I want a used Recovery Code to become invalid immediately, so that it cannot be replayed.
15. As a Workspace Member, I want regenerating Recovery Codes to invalidate every unused code from the old set, so that there is only one valid recovery set.
16. As an Admin, I want Recovery Code generation, use, failure lockout, and regeneration audited without secret values, so that recovery is accountable without leaking credentials.
17. As a Workspace Member, I want an inactive session to lock after 30 minutes when I am not recording, so that abandoned sessions do not remain accessible.
18. As a Workspace Member making a Recording, I want inactivity locking not to interrupt active capture, so that security controls do not destroy a Call.
19. As a Workspace Member whose inactivity threshold passed while recording, I want the application to lock immediately after Stop & Save, so that the exception lasts only for capture.
20. As a Workspace Member, I want absolute reauthentication after 12 hours, so that a continuously used session does not remain valid indefinitely.
21. As an Admin, Manager, or Platform Admin performing a privileged action, I want fresh MFA when required, so that an old authenticated session is insufficient for sensitive changes.
22. As a Workspace Member, I want authentication and recovery endpoints rate-limited, so that automated guessing and abuse are contained.
23. As an Admin, I want repeated Recovery Code failures to trigger a one-hour lock and an alert, so that likely recovery attacks are visible.
24. As a Workspace Member, I want to belong to exactly one Workspace, so that access and governance have an unambiguous organizational boundary.
25. As a production operator, I want the pilot limited to ten active Workspace Members across all production Workspaces, so that support and operational commitments match the intended launch scale.
26. As a production operator, I want Suspended and Former Workspace Members excluded from the active-member cap, so that offboarding does not consume pilot capacity.
27. As a Workspace Member, I want a clear message when my browser cannot record, so that I understand why recording controls are unavailable.
28. As a Workspace Member using Chrome desktop on macOS or Windows, I want microphone, tab-audio, and combined-source recording, so that I can capture supported Calls.
29. As a Workspace Member using another modern browser, I want to sign in, play Calls, read Transcripts, complete Reviews, and administer permitted settings, so that only capture is browser-restricted.
30. As a Workspace Member, I want to attest before every Call that required notices and consents were obtained, so that Cauli records the actor and time of the confirmation.
31. As a Workspace Member, I want the Recording Attestation wording approved by the operator, so that the product describes responsibility accurately without claiming the checkbox itself makes recording lawful or was counsel-reviewed.
32. As a Workspace Member, I want to give a Call an optional title before recording, so that it is easier to identify later.
33. As a Workspace Member, I want an untitled Call to use its date and time as a fallback label, so that every Call remains identifiable.
34. As a Call owner, I want to rename my Call after recording, so that I can improve its metadata.
35. As a Call owner, I want Managers and Admins prevented from silently rewriting my title, so that ownership and attribution remain clear.
36. As a Workspace Member, I want recording duration limited to three hours, so that the supported operating boundary is enforced.
37. As a Workspace Member, I want local chunk durability during capture, so that a tab crash or network interruption does not automatically lose the Recording.
38. As a Workspace Member, I want an unexpectedly ended capture recovered as an Incomplete Recording, so that I can finalize or discard it deliberately.
39. As a Workspace Member, I want a partially lost audio source represented as a Degraded Recording while preserving surviving audio, so that useful material is not discarded.
40. As a Workspace Member navigating away during capture, I want to choose Stay or Leave and save as Incomplete, so that navigation never silently continues capture or destroys recoverable audio.
41. As a Workspace Member, I want capture to stop when I leave the recording experience, so that Cauli never records invisibly after navigation.
42. As a Workspace Member, I want the product to state that Transcript generation is English-only, so that language expectations are explicit.
43. As a Workspace Member, I want Stop & Save to create a durable Call before background work proceeds, so that processing failure cannot erase the captured business record.
44. As a Workspace Member, I want a nonterminal Call to refresh about every five seconds, so that I see processing progress without manually reloading.
45. As a Workspace Member, I want polling to stop when a Call reaches a terminal state, so that the application does not generate unnecessary traffic.
46. As a Workspace Member, I want most Calls of 60 minutes or less Ready within five minutes of Stop & Save, so that I can continue my workflow promptly.
47. As a production operator, I want at least 95% of Calls of 60 minutes or less to meet the five-minute Ready target, including queue time, so that the promise has a measurable definition.
48. As a production operator, I want provider-wide incidents reported separately from the normal service-level calculation, so that exceptional dependency outages remain visible rather than silently distorting the metric.
49. As a Workspace Member, I want Calls longer than 60 minutes and up to three hours supported without a five-minute commitment, so that the product is honest about its operating envelope.
50. As a production operator, I want five simultaneous Calls of up to 60 minutes to meet the processing target under a representative load test, so that the pilot has demonstrated capacity.
51. As a Workspace Member, I want recoverable processing failures retried idempotently, so that retries do not create duplicate or corrupted artifacts.
52. As a Workspace Member, I want exhausted automated retries to produce a clear Needs Attention state, so that failure is actionable.
53. As a Workspace Member, I want Budget Paused to preserve Source Audio and wait without consuming a retry attempt, so that cost controls do not turn into data loss.
54. As an Admin, I want to see when a Workspace is Budget Paused, so that I can explain the delay to Workspace Members.
55. As a Platform Admin, I want a default daily processing budget of $10 per Workspace and $50 globally, so that pilot costs are bounded.
56. As a Platform Admin, I want an 80% budget warning, so that I can intervene before processing pauses.
57. As a Platform Admin, I want all budget changes audited, so that spending authority is accountable.
58. As a Workspace Member, I want Budget Paused jobs to resume automatically after the daily reset or an authorized limit change, so that no manual retry is required.
59. As a production operator, I want content-scrubbed exception and performance monitoring for the web application and worker, so that failures can be diagnosed without copying customer content into telemetry.
60. As a production operator, I want telemetry to include release, route or job kind, timing, queue depth, and pseudonymous identifiers, so that operational patterns can be investigated.
61. As a Workspace Member, I want audio, Transcript text, Review text, email addresses, signed URLs, credentials, and request bodies excluded from telemetry, so that observability does not become a content store.
62. As a production operator, I want alerts for health failures, queue age over five minutes, processing service-level breaches, and repeated Needs Attention outcomes, so that operational failures are noticed promptly.
63. As a Workspace Member, I want a paginated Calls list with 50 Calls per page, so that performance does not degrade as the Workspace grows.
64. As a Workspace Member, I want to filter Calls by date, owner, processing state, Review state, quality outcome, Review Assignee, and Follow-up state, so that I can find work without scanning every Call.
65. As a Workspace Member, I want metadata search limited to Call title and owner, so that discovery is useful without introducing full-Transcript indexing.
66. As a Workspace Member with Call access, I want to play the processed media and seek from Transcript timestamps, so that the Call and Transcript work together.
67. As a Workspace Member with Call access, I want to download permitted MP3, Source Audio, and WAV artifacts, so that existing media-export workflows remain available.
68. As a Workspace Member with Call access, I want to download the Transcript as TXT or SRT, so that I can use it outside Cauli.
69. As an Admin, I want every media and Transcript download audited without storing the signed URL or content, so that extraction is accountable.
70. As a Workspace Member, I want export and retry endpoints rate-limited, so that one session cannot create unbounded load.
71. As an Admin, I want a Scorecard criterion marked Required or optional, so that evaluation rules match the criterion’s importance.
72. As a Manager completing a Review, I want an optional criterion to allow N/A, so that inapplicable criteria do not distort the score.
73. As a Manager completing a Review, I want N/A optional criteria removed from the denominator, so that weighted scores remain meaningful.
74. As an Admin, I want published Scorecard Versions to remain immutable, so that historical Reviews retain their original definition.
75. As an Admin, I want analytics segmented by Scorecard Version, so that scores based on different definitions are not conflated.
76. As an Admin, I want to mark Scorecard Versions explicitly comparable before cross-version trends appear, so that a visible methodology decision precedes combined analytics.
77. As a Manager or Admin, I want an unassigned Review queue, so that Calls awaiting quality assurance are visible.
78. As a Manager or Admin, I want to claim an unassigned Review, so that responsibility is explicit.
79. As an Admin, I want to assign or reassign one Review Assignee per Call, so that Reviews can be distributed deliberately.
80. As an Admin, I want to assign Reviews in bulk from a filtered list, so that pilot operations do not require opening every Call.
81. As an Admin, I want every individual and bulk Review assignment recorded as an Audit Event, so that ownership changes remain traceable.
82. As a Review Assignee, I want to be the only Manager who can edit my assigned Review, so that concurrent responsibility is unambiguous.
83. As an Admin, I want to edit an assigned Review when intervention is required, so that Workspace governance is not blocked by absence.
84. As a Call owner, I want an In Progress Review hidden from me, so that draft evaluation does not appear as finalized feedback.
85. As a Call owner, I want a submitted Reviewed or Needs Follow-up result visible, so that completed feedback is actionable.
86. As a reviewer, I want optimistic concurrency protection, so that a stale browser cannot overwrite newer Review work.
87. As a Workspace Member with Review access, I want to inspect every immutable Review Revision, including answers, comments, summary, score, outcome, submitter, and Follow-up state, so that history is complete rather than metadata-only.
88. As a Review Assignee, I want a Needs Follow-up submission to create a tracked Follow-up assigned to the Call owner, so that the outcome creates accountable work.
89. As a Review Assignee, I want the Follow-up due date required and defaulted to seven calendar days, so that unresolved work always has a deadline.
90. As a Call owner, I want to mark my Follow-up Resolved, so that I can signal completion.
91. As a Review Assignee or Admin, I want to verify Follow-up closure, so that self-reported completion is reviewed.
92. As a Follow-up owner, Review Assignee, or Admin, I want unresolved work to become Overdue after its due date, so that delay is visible.
93. As a Workspace Member, I want in-application queues for my open and Overdue Follow-ups, so that email is not required to manage the workflow.
94. As a Manager or Admin, I want a dashboard showing Call volume, percent Ready within five minutes, failures, Review completion, average score and trend, unassigned Reviews, and open or Overdue Follow-ups, so that Workspace operations are visible.
95. As a Manager or Admin, I want dashboard filters for date, owner, Review Assignee, and state, so that metrics can answer operational questions.
96. As a Workspace Member, I want every Workspace to have a mandatory Retention Policy, so that Call content cannot be retained forever by omission.
97. As an Admin, I want to choose a Retention Policy of 30, 60, 90, 180, or 365 days, with 90 days as the default, so that the policy is bounded and explicit.
98. As a Workspace Member, I want the scheduled deletion date visible on Call Detail, so that I know how long the Call remains available.
99. As a Workspace Member, I want to view the Workspace Retention Policy read-only, so that the governance rule is transparent.
100. As an Admin, I want to change the Retention Policy prospectively for the Workspace, so that governance can respond to business needs.
101. As an Admin, I want expiration to use the same audited deletion workflow as manual deletion, so that every owned artifact is removed consistently.
102. As a Workspace Member, I want deletion to remove the Call, Recording, Source Audio, Transcript, Reviews, exports, and derived artifacts together, so that partial deletion does not leave content behind.
103. As an Admin, I want privileged and destructive actions recorded as immutable, content-free Audit Events, so that governance evidence cannot be rewritten.
104. As an Admin, I want Audit Events to identify actor, action, target, time, and safe change metadata, so that they are useful without preserving customer content or secrets.
105. As an Admin, I want Audit Events to cover role and membership changes, MFA resets, Recovery Codes, Scorecards, retention, Review assignments, Follow-ups, exports, retries, downloads, deletion, and budgets, so that material actions are not omitted.
106. As an Admin, I want Audit Events retained for one year independently of Call deletion, so that evidence outlives the content it governs.
107. As an Admin, I want the Audit Log paginated and filterable by date, actor, action, and entity, so that investigations are practical.
108. As an Admin, I want to export the Audit Log as CSV, so that I can provide governance evidence outside the product.
109. As an Admin, I want the act of exporting Audit Events itself audited, so that governance data extraction is accountable.
110. As an Admin removing a Workspace Member, I want access revoked immediately and new assignments prevented, so that offboarding takes effect at once.
111. As an Admin removing a Workspace Member, I want open Reviews and Follow-ups reassigned first, so that no active obligation becomes ownerless.
112. As a Workspace Member, I want historical work attributed to a Former Workspace Member without retaining their email indefinitely, so that records remain intelligible while personal data is minimized.
113. As an Admin, I want the removed person’s authentication identity deleted and profile anonymized to a pseudonymous historical identifier, so that offboarding is substantive.
114. As a Workspace Member, I want Source Audio copied to an independent encrypted backup within 15 minutes of Stop & Save, so that a primary storage failure does not eliminate the authoritative media.
115. As a Workspace Member, I want backup work asynchronous to Call readiness, so that backup latency does not delay normal use.
116. As a production operator, I want backup lag alerted and retried until success or authorized deletion, so that a missed copy cannot fail silently.
117. As a production operator, I want backup payloads protected by per-Call authenticated encryption and versioned wrapped keys, so that compromise of a backup target does not expose Source Audio.
118. As a production operator, I want opaque backup object names and encrypted manifests, so that Workspace and Call metadata are not revealed by storage paths.
119. As a production operator, I want application backup credentials able to create but not overwrite or delete immutable copies, so that application compromise cannot erase recovery data.
120. As an Admin deleting a Call, I want a separately authorized retention process to remove its backups through the same deletion workflow, so that deletion obligations reach every copy.
121. As a production operator, I want the backup master key absent from the VPS and Peely SSD, with a production secret and offline recovery path, so that stored ciphertext and keys do not share a failure domain.
122. As a production operator, I want an always-on VPS backup in a provider, region, and credential boundary independent of Supabase and Railway, so that one provider failure does not remove both copies.
123. As a production operator, I want encrypted VPS backups synchronized and checksum-verified daily to Peely SSD, so that there is an additional offline recovery copy.
124. As a production operator, I want an alert after 48 hours without a successful Peely sync, so that the offline copy does not become unknowingly stale.
125. As a production operator, I want a four-hour recovery-time objective with checksum and authentication-tag verification, so that Source Audio recovery is both timely and trustworthy.
126. As a production operator, I want a Supabase point-in-time recovery drill before launch and quarterly thereafter, so that database recovery is demonstrated rather than assumed.
127. As a Platform Admin, I want a separate control plane at `admin.cauli.pro`, so that platform-wide authority is not mixed into Workspace administration.
128. As a Platform Admin, I want separate authentication, mandatory MFA, short sessions, and complete Audit Events, so that system-wide access receives stronger controls.
129. As a Workspace Member, I want Platform Admins to have no routine access to Call content, so that operational authority does not imply unrestricted customer-content access.
130. As a Platform Admin responding to an exceptional incident, I want a break-glass grant limited to one Workspace or Call, requiring fresh MFA, reason, and expiration, so that exceptional content access is narrow and temporary.
131. As an Admin, I want notification when a Platform Admin receives break-glass access to my Workspace, so that exceptional access is transparent.
132. As a Platform Admin, I want to create a Workspace, set its name, Retention Policy, and budget, and invite its initial Admin, so that pilot provisioning is controlled.
133. As a Platform Admin, I want to inspect Workspace health without viewing content, so that support does not require routine content access.
134. As a Platform Admin, I want to suspend and reactivate a Workspace with a recorded reason, so that access can be contained without deleting content.
135. As a Workspace Member in a Suspended Workspace, I want member access, new recording, transcription, and export blocked while backup, retention, auditing, and security controls continue, so that suspension contains activity without abandoning governance.
136. As an Admin, I want to request Workspace Closure and cancel it during a 30-day suspension period, so that closure is deliberate and recoverable before final deletion.
137. As a Platform Admin, I want to confirm a Workspace Closure with a reason before the countdown begins, so that irreversible deletion has operator oversight.
138. As a Workspace Member, I want Workspace content and backups deleted irreversibly after the closure period while content-free Audit Events remain for one year, so that closure honors both deletion and governance obligations.
139. As a Platform Admin, I want audited global and Workspace kill switches for new recording, transcription, downloads, Review submission, and backup deletion, so that incidents can be contained precisely.
140. As a Workspace Member, I want kill switches to pause work rather than delete queued work, so that incident response does not create data loss.
141. As a customer or operator, I want `status.cauli.pro` to report only service-level status for web, authentication, uploads, processing, downloads, and backup freshness, so that availability is transparent without exposing Workspace details.
142. As a production operator, I want Critical and High alerts delivered by email, so that the agreed pilot alert channel is used consistently.
143. As a prospective customer, I want operator-approved Terms, Privacy Notice, DPA, subprocessors, recording-responsibility language, retention and deletion terms, and security and incident contacts before launch, so that the pilot publishes an explicit legal package without misrepresenting it as counsel-reviewed.
144. As a Workspace Member, I want to accept the current Terms and Privacy Notice during Invitation Activation, so that acceptance is versioned and evidenced.
145. As an initial Admin, I want to accept the DPA and recording responsibilities during activation, so that Workspace-level obligations are acknowledged.
146. As a Workspace Member, I want material legal changes to require reacceptance before access continues, so that acceptance is tied to the current terms.
147. As a Workspace Member, I want critical workflows to meet WCAG 2.2 AA expectations with keyboard and screen-reader support, so that the pilot is usable without a mouse or visual-only cues.
148. As a Workspace Member, I want authentication pages and navigation usable within a p95 of 2.5 seconds on normal broadband, so that routine access feels responsive.
149. As a Workspace Member, I want non-media APIs to respond within a p95 of 500 milliseconds under pilot load, so that administrative and QA work remains responsive.
150. As a Workspace Member starting capture, I want visible recording feedback within one second after granting permission, so that I know capture began.
151. As a production operator, I want continuous monitoring and human support Monday through Friday, 9 a.m. to 6 p.m. Eastern excluding federal holidays, so that pilot expectations are explicit.
152. As a pilot customer, I want Critical incidents acknowledged within 30 minutes during support hours, High incidents within two hours, and Normal requests within two business days, so that support has measurable targets.
153. As a production operator, I want code, dependencies, container images, and an SBOM checked before release, so that known Critical or High runtime vulnerabilities cannot silently enter production.
154. As a production operator, I want a documented, time-limited exception for any accepted Critical or High runtime vulnerability, so that release risk has an accountable owner and expiration.
155. As a maintainer, I want every production change merged to `main` through a pull request with required CI and no force push, deletion, or check bypass, so that production has a canonical reviewed history.
156. As the sole maintainer, I want zero mandatory external approvals but a self-review record in the pull request description, so that branch protection is compatible with current staffing.
157. As a production operator, I want an isolated staging stack with separate web, worker, Supabase, Storage, provider credentials, and monitoring environment, so that acceptance testing cannot mutate production.
158. As a production operator, I want one immutable container image built from `main`, tested in staging, and promoted by exact digest to production, so that production runs the artifact that passed acceptance.
159. As a production operator, I want database changes released through expand-migrate-contract steps with a recorded pre-migration recovery timestamp, so that schema evolution remains recoverable.
160. As a production operator, I want manual release sign-off to cover activation, security, real-audio recording on macOS and Windows, processing load, playback, Transcript, downloads, Review, Follow-up, retention, Audit Events, backup restore, RLS, and accessibility, so that the complete flow is proven before promotion.
161. As a maintainer, I want the public repository to remain proprietary and all rights reserved, so that public visibility does not grant an open-source license.
162. As a security reporter, I want a documented security-reporting path and private vulnerability reporting, so that sensitive reports are not filed publicly.
163. As a maintainer, I want secret scanning, push protection, dependency alerts, weekly dependency update pull requests, and full-history leak checks, so that public-source risk is actively managed.
164. As a production operator, I want production credentials separated among the web application, worker, Platform Admin control plane, VPS backup writer, retention deleter, and Peely sync, so that one compromise does not grant every capability.
165. As a production operator, I want credential rotation required after a suspected incident, so that known or potentially exposed secrets are replaced promptly.
166. As a Workspace Member, I want a per-request nonce Content Security Policy with no production unsafe script execution, so that injected browser code cannot read Call content or credentials.
167. As a production operator, I want exact browser security headers and capability permissions verified in CI and staging, so that recording works without granting unrelated browser authority.
168. As a production operator, I want the free U.S.-region Sentry service configured separately for web and worker, so that pilot errors and critical traces are visible without adding another paid service.
169. As a Workspace Member, I want Sentry sampling, scrubbing, and disabled content-bearing features proven with canary data, so that telemetry does not contain customer content or direct identifiers.
170. As a pilot customer, I want Cauli’s persistent production systems hosted in verified U.S. regions, so that the product can make an accurate U.S.-Hosted Production promise.
171. As a pilot customer, I want possible transient international OpenRouter processing disclosed while zero retention and denied provider data collection remain mandatory, so that the geography and privacy boundary is honest.
172. As a production operator, I want every web, identity, worker, Platform Admin, backup, retention, Peely, release, and monitoring duty to use a separate principal, so that one compromised credential cannot inherit unrelated authority.
173. As a production operator, I want automated denial tests for every production principal, so that least privilege is demonstrated rather than inferred from secret names.
174. As a production operator, I want each Source Audio Backup data key wrapped by both managed KMS and an offline recovery public key, so that neither worker compromise nor loss of the KMS provider destroys the recovery path.
175. As a production operator, I want two sealed offline recovery bundles, defined restore procedures, and recurring drills, so that recovery-key custody is physically resilient and operationally proven.
176. As a prospective customer, I want an accurate Regulated-Use Disclaimer, so that factual security controls are not mistaken for certification, compliance, readiness, or exemption from applicable law.
177. As a prospective customer, I want the Regulated-Use Disclaimer available on public Legal and Security pages and linked from Invitation Activation, so that I can see it without authentication or an additional acceptance gate.
178. As a production operator, I want release checks to reject unsupported regulated-use claims, so that product, repository, and public materials remain consistent with the pilot’s actual assessment status.
179. As a prospective Workspace Member, I want `cauli.pro` to provide public product and policy information with a Log in option that opens `app.cauli.pro/login`, so that public information and authenticated work have a clear entry path.
180. As an authenticated person, I want Cauli to derive functionality from my active server-side Workspace membership and roles, so that client state or a directly entered URL cannot expand my authority.
181. As a returning authenticated person, I want the public Log in option to send me directly to my authorized landing page, so that I do not repeat authentication unnecessarily.
182. As a disabled or unassigned person, I want application access denied after authentication, so that proving identity alone does not grant Workspace or Platform Admin authority.
183. As a production operator, I want staging and production in separate Railway projects, Supabase projects, credentials, storage, and provider keys, so that acceptance work cannot cross the production boundary.
184. As a production operator, I want a dedicated Cauli-owned free Sentry organization with separate web and worker projects, so that observability ownership and configuration are explicit.
185. As a production operator, I want a new AWS account used exclusively for Cauli KMS, so that backup decryption authority is isolated from unrelated cloud workloads.
186. As a production operator, I want the shared Netcup host to isolate Cauli behind a dedicated service, capacity ceiling, create-only intake, and separate retention authority, so that co-hosted workloads do not gain backup access.
187. As a production operator, I want the offline recovery identity encrypted and sealed at the operator’s residence and the partner’s office safe, so that loss of one location does not remove recovery.
188. As a production operator, I want timestamped U.S.-region evidence before launch, after infrastructure changes, and quarterly, so that the U.S.-Hosted Production statement remains verifiable.
189. As a production operator, I want every provider login, MFA, payment, physical-custody, legal-approval, real-device, and release-signoff task in a step-by-step human runbook, so that agents never invent or silently skip human obligations.
190. As a maintainer, I want explicit human tickets to block only the work or launch decision that requires human authority, so that agent-ready implementation remains accurately distinguishable from operator action.

## Implementation Decisions

### Pilot boundary

- The release is a controlled production pilot for no more than ten active Workspace Members across all production Workspaces. Suspended and Former Workspace Members do not count.
- A person belongs to exactly one Workspace. Multi-Workspace membership is not introduced.
- Provisioning is invite-only and performed by an Admin or Platform Admin; there is no self-service registration, subscription, or billing flow.
- The service is limited to U.S.-based use and U.S.-Hosted Production. Persistent Supabase, Railway, Sentry, VPS, backup, and operational systems require verified U.S. regions; OpenRouter and its model providers may process Source Audio transiently elsewhere under mandatory zero-data-retention and denied-data-collection controls. The product must not claim strict U.S. data residency.
- The service is English-only and makes no regulated-use or certification claims.
- Chrome desktop on macOS and Windows is the supported capture surface. Other current desktop browsers support non-recording product workflows and must present an explicit recording-unsupported state.
- A Recording may be no longer than three hours.

### Identity, activation, and session security

- `cauli.pro` is a public product and policy site whose Log in option opens `app.cauli.pro/login`. An already-authenticated person is sent directly to the server-authorized landing page.
- Application functionality is derived exclusively from active server-side Workspace membership and roles. A Workspace Member enters their single Workspace, a Platform Admin receives the authorized Platform Admin entry point, and a disabled or unassigned identity receives no application access. Client state and directly entered URLs cannot expand authority.
- Invitation Activation is a stateful, one-time flow. The invitation proves email control; activation requires password creation, current legal acceptance, and all role-required factors before application access.
- Routine magic-link authentication is removed after activation. Password reset remains email-based and time-limited.
- TOTP MFA is mandatory for Admins and Managers and optional for the Member Role. Platform Admin authentication is separate and always requires MFA.
- Cauli owns Recovery Code generation because the authentication provider does not provide this feature. Generate ten cryptographically random single-use codes, display plaintext only once, offer copy and download, and store only keyed hashes.
- Recovery Code comparison must be constant-time. Regeneration invalidates all prior unused hashes; successful use atomically consumes one code.
- A Recovery Code may be submitted only after password verification and may authorize only the forced reset, reenrollment, and verification of TOTP. It cannot create a normal application session.
- Audit Events for Recovery Codes contain action and safe metadata only, never a plaintext code, raw hash, download content, or factor secret.
- Sessions lock after 30 minutes of inactivity except during active capture, then lock after Stop & Save if the threshold elapsed. Absolute reauthentication occurs after 12 hours. Sensitive actions require fresh MFA.
- Rate limits are:
  - Password reset: five requests per hour per email-and-IP pair.
  - Recovery Code: five failures in 15 minutes, followed by a one-hour lock and Admin alert.
  - Invitations: 20 per hour per Workspace.
  - Call creation: ten per minute per Workspace Member.
  - Retry and export: ten per hour per Call.
  - Review submissions: 30 per hour per reviewer.
  - Signed downloads: 60 per hour per Workspace Member.
  - Recording chunk upload is not throttled by an application rate limit.

### Recording and durable capture

- Every capture requires a Recording Attestation. Store the acting Workspace Member and timestamp. The operator must approve the wording before launch; the product must not imply that checking the box independently establishes lawfulness or that counsel reviewed the wording.
- Call title is optional before capture, with a date-and-time fallback. The Call owner may rename it after capture. Managers and Admins can view other owners’ titles but cannot silently rewrite them.
- Preserve microphone, tab-audio, and combined-source capture, local chunk durability, Source Audio loss handling, Degraded Recording behavior, and Incomplete Recording recovery.
- Attempted navigation or window close during capture presents Stay and Leave-and-save-as-Incomplete choices. Capture must not continue after leaving.
- Stop & Save durably establishes the Call and Recording before asynchronous processing. Pause and Resume are not added.
- The product identifies Transcript generation as English-only.

### Processing, cost, and observability

- Nonterminal Calls and exports refresh approximately every five seconds and stop polling at a terminal state.
- The external promise is “Most Calls should be ready within 5 minutes.” Operationally, at least 95% of Calls no longer than 60 minutes must be Ready within five minutes of Stop & Save, including queue time. Provider-wide incidents are reported separately. Calls up to three hours remain supported without this service-level target.
- Demonstrated pilot capacity is five simultaneous Calls of no more than 60 minutes while meeting the target. Worker concurrency must be sized from load-test evidence rather than assumed from the current single-worker setting.
- Existing checkpointing, idempotency, leases, retry, and Needs Attention semantics remain. Budget Paused is a separate non-failure state that consumes no retry attempt.
- Default processing limits are $10 per Workspace per day and $50 globally per day, with an 80% warning. Platform Admin changes are audited. Provider pricing must be configurable and revalidated before launch rather than hard-coded into the user interface.
- While Budget Paused, capture and Source Audio backup continue; new transcription work waits. The affected Admin can see the state. Only a Platform Admin, automatic daily reset, or configured policy can restore capacity, after which jobs resume automatically.
- Create a dedicated Cauli-owned Sentry organization on Sentry’s free U.S.-region Developer plan with the operator as its sole initial owner. Use `cauli-web` and `cauli-worker` projects with staging/production environments. Identify releases by the `main` commit and immutable image digest, upload source maps privately during the build, exclude them from public artifacts, and send browser events through a same-origin tunnel.
- Capture all errors and critical-journey/worker traces, sample routine navigation and noncritical APIs at 10%, and exclude static assets, health/status polling, and Recording chunk uploads. Make sampling environment-configurable, alert at 80% of the plan’s error or span quota, and fail open if Sentry is unavailable or quota limited. Cauli’s durable metrics, not sampled Sentry events, remain the processing-service-level source of truth.
- Send exceptions, release, route or job kind, timing, queue depth, provider/model identity, error class, and pseudonymous identifiers only. Disable Session Replay, screenshots, attachments, User Feedback, profiling, console/log ingestion, Seer/AI, automatic request-body capture, and default PII.
- Scrub IPs, cookies, authorization headers, query strings, request bodies, emails, titles, Transcripts, Review text, signed URLs, and filenames before sending and again through organization-level server-side rules. Automated canaries must demonstrate that forbidden values do not reach Sentry. Retain events for no more than the free plan’s 30-day lookback.
- Alert on failed health checks, queue age above five minutes, service-level breaches, repeated Needs Attention outcomes, budget thresholds, backup lag, and stale offline synchronization.

### Calls, Transcripts, and discovery

- Replace fixed-size Call retrieval with cursor pagination at 50 Calls per page.
- Support filters for date, owner, processing state, Review state, quality outcome, Review Assignee, and Follow-up state.
- Search indexes Call title and owner metadata only. Full-Transcript search is not introduced.
- Preserve playback, timestamp seeking, MP3, Source Audio and WAV downloads, retry, and deletion behavior.
- Add TXT and SRT Transcript exports. All media and Transcript exports use the existing access boundary, short-lived signed delivery, rate limits, and Audit Events. Audit data must not include content or signed URLs.
- Direct Transcript editing is not introduced. Future correction must use regeneration or an explicitly audited annotation model.

### Scorecards, Reviews, and Follow-ups

- A Scorecard criterion has a Required toggle. An optional criterion supports N/A, which removes its weight from the score denominator.
- Preserve immutable published Scorecard Versions. Dashboards and trends are segmented by version unless an Admin explicitly records that selected versions are comparable.
- Each Call has at most one Review Assignee. A Manager or Admin may claim an unassigned Review; an Admin may assign or reassign it individually or in bulk.
- Only the Review Assignee or an Admin may edit an assigned Review. Assignment and reassignment are audited, including each affected Call in a bulk change set.
- Preserve draft privacy, submitted visibility, optimistic concurrency, and immutable Review Revisions.
- The revision viewer includes answers, comments, summary, score, outcome, Follow-up state, submitter, and submission time.
- A Needs Follow-up outcome creates a Follow-up assigned to the Call owner with a required due date defaulting to seven calendar days.
- The owner marks a Follow-up Resolved. The Review Assignee or an Admin verifies closure. An unresolved Follow-up becomes Overdue after its due date.
- Open and Overdue work appears in application navigation and queues for the owner, Review Assignee, and Admin. No processing or Follow-up email workflow is introduced.
- The Manager/Admin dashboard reports Call volume, percentage Ready within five minutes, processing failures, Review completion, average score and trend, unassigned Reviews, and open and Overdue Follow-ups. Queries are bounded and filterable by date, owner, assignee, and state.

### Retention, deletion, Audit Events, and offboarding

- Every Workspace has one mandatory Retention Policy. Allowed values are 30, 60, 90, 180, and 365 days; the default is 90 days and there is no retain-forever choice.
- Show scheduled deletion on Call Detail and expose the current policy read-only to all Workspace Members. Only an Admin can change it.
- There are no per-Call retention exceptions. Expiration and manual deletion use one idempotent, audited workflow that removes the Call, Recording, Source Audio, Transcript, Review data, exports, derived artifacts, and Source Audio Backups.
- Audit Events are immutable and content-free. They include actor, action, target, timestamp, request/correlation identity where safe, and structured safe metadata describing the change.
- Audit coverage includes privileged access, role and membership changes, invitations, MFA resets, Recovery Code lifecycle, Scorecard publication, retention changes, Review assignment, Follow-up state, exports, retries, downloads, deletion, budget changes, Workspace suspension and closure, kill switches, backup restore, releases, and break-glass access.
- Audit Events have a one-year retention independent of Call and Workspace content deletion. Provide cursor pagination, date/actor/action/entity filters, and CSV export; exporting is itself audited.
- Offboarding revokes access immediately, prevents new assignment, and requires reassignment of open Reviews and Follow-ups.
- Delete the authentication identity and anonymize the application profile to a pseudonymous Former Workspace Member identity. Preserve historical attribution only while its owning records remain under retention.

### Independent encrypted Source Audio recovery

- Supabase remains primary. Database point-in-time recovery is necessary but is not treated as a Storage backup.
- Back up Source Audio to the existing ARM64 Netcup VPS in Manassas, Virginia. The shared host may retain other workloads, but Cauli uses a dedicated sandboxed service account, isolated directory or volume, narrow mTLS receiver, create-only intake, privileged re-ownership helper, separate retention principal, and an 800 GB enforced capacity ceiling. Other workloads receive no Cauli credentials or filesystem access.
- Host-root compromise is accepted as capable of destroying the VPS copy but not decrypting it. Peely provides the additional failure boundary and never mirrors arbitrary VPS deletion; it applies only authenticated retention instructions.
- Encrypt each Source Audio backup before it leaves the worker using AES-256-GCM with a unique per-Call data key. Wrap every data key twice: with a dedicated AWS KMS RSA-4096 asymmetric key in `us-east-2` using RSA-OAEP-SHA256 and with a standard `age` X25519 recipient.
- AWS KMS lives in a new AWS account used exclusively for Cauli. Root has MFA and no access keys. The worker holds only the KMS public key and the `age` recipient and has no AWS runtime credential; a normally disabled MFA-protected restore role may call `kms:Decrypt` only during an audited recovery.
- Generate the `age` keypair offline, passphrase-encrypt the identity, and keep two identical sealed recovery bundles with machine-readable media, text/QR recovery material, and a separately verifiable public-key fingerprint. Copy A is held in the operator’s local fire-resistant safe and Copy B in the partner’s office safe. The password-manager emergency kit remains separate from both and from Peely.
- The offline private identity is never stored in Railway, Supabase, AWS, the VPS, Sentry, GitHub, OpenRouter, or Peely.
- Inspect seals and fingerprints quarterly without importing the key. Prove an online KMS restore quarterly and an offline restore before launch, after each recovery-key rotation, and annually. Recovery uses an isolated ephemeral U.S.-hosted machine, fresh Platform Admin MFA, a recorded reason, in-memory key use, and deletion of temporary plaintext within 24 hours.
- Key versioning must preserve restore until every dependent backup expires or is verified as rewrapped. Suspected exposure rotates the affected recovery key and rewraps every unexpired backup.
- Use opaque object names and encrypted manifests. Neither storage target should reveal Workspace identity, Call identity, title, owner, or other customer metadata.
- The application/worker credential can create but cannot overwrite or delete backup objects. A separately authorized retention identity performs deletion after an application-authenticated deletion request.
- Backup is asynchronous and does not gate Ready. Target VPS completion within 15 minutes of Stop & Save, alert on lag, and retry until success or authorized deletion.
- Recovery has a four-hour objective and must verify checksum and authentication tag before restored Source Audio is accepted.
- Peely synchronization runs daily, verifies checksums, and alerts after 48 hours without success. The drive should remain disconnected when operationally practical.
- Perform a restore-to-new-project database drill before launch and quarterly thereafter. Verify Workspace, membership, Call, Review, Audit Event, job, and encrypted-backup-manifest relationships. Perform a Source Audio restore and media regeneration as part of the drill.

### Platform Admin control plane and Workspace lifecycle

- Platform Admin is a distinct system role, not a Workspace role. Its functions live at `admin.cauli.pro` with separate authentication, mandatory MFA, short sessions, fresh-MFA gates, and complete auditing.
- Platform Admin capabilities include budgets, health, releases, backup operations, service controls, Workspace creation, initial Admin invitation, suspension/reactivation, and closure confirmation.
- Platform Admins have no routine Call-content access. Break-glass access must be scoped to one Workspace or Call, require fresh MFA and a reason, expire automatically, create Audit Events, and notify the affected Admin.
- Workspace health views expose service and lifecycle facts without customer content.
- A Suspended Workspace blocks member access, new recording, transcription, and export. It pauses queued processing without consuming attempts. Backup, retention, auditing, and security controls continue.
- Workspace Closure begins with an Admin request and Platform Admin confirmation with reason. It produces a 30-day cancellable suspension, then irreversibly deletes content and backups. Content-free Audit Events remain for their one-year term.
- Provide audited global and per-Workspace kill switches for new recording, transcription, downloads, Review submission, and backup deletion. Kill switches pause or reject new work and never delete queued work.
- `status.cauli.pro` shows service-level health for web, authentication, uploads, processing, downloads, and backup freshness. It contains no Workspace identifiers, customer content, or internal diagnostics.

### Infrastructure topology and provider ownership

- Production and staging use separate private Railway projects. Each project contains a public web service and a worker with no public domain, and every service is pinned to Railway’s Virginia region `us-east4-eqdc4a`.
- Production and staging use separate Supabase projects in `us-east-1`, separate Storage, separate OpenRouter keys and spending limits, separate credentials, and synthetic data only in staging.
- Cloudflare routes `cauli.pro` to the public site and policies, `app.cauli.pro` to the production application, `admin.cauli.pro` to production Platform Admin, `staging.cauli.pro` and `admin.staging.cauli.pro` to staging, and `status.cauli.pro` to public service status; `www.cauli.pro` redirects to the apex. Cloudflare Access protects staging and both administration surfaces.
- The operator controls the Cloudflare account and `cauli.pro` zone. DNS automation uses separate least-privilege staging and production API tokens scoped to the zone rather than the Global API Key.
- The Sentry and AWS accounts are newly created, Cauli-owned, and secured by the operator before an implementation agent receives narrowly scoped configuration authority. Existing Cloudflare, Railway, Supabase, OpenRouter, Netcup, and Peely ownership is verified through the human runbook.
- Before launch, retain private timestamped provider screenshots or API output proving Railway `us-east4-eqdc4a`, Supabase `us-east-1`, AWS KMS `us-east-2`, Netcup Manassas, and the Sentry U.S. data region. GitHub stores only a content-free verification record.
- Deployment checks reject configured region mismatches. Region evidence is refreshed after every infrastructure change and at least quarterly.

### Legal, support, accessibility, and performance

- Before customer use, the operator approves the Terms, Privacy Notice, DPA, subprocessor disclosure, Recording Attestation and consent-responsibility language, retention/deletion terms, and security and incident contact language. Counsel review is deferred and explicitly out of the current pilot scope; product and public materials must not imply that counsel reviewed these documents.
- Version all legal documents and acceptance. Every Workspace Member accepts Terms and Privacy during Invitation Activation; the initial Admin also accepts the DPA and recording responsibilities. Material changes require reacceptance before further access. Acceptance is immutable and audited.
- Do not claim that the pilot is certified, compliant, ready, or exempt under SOC 2, ISO 27001, HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or another regulated regime without a separate assessment and accepted obligation.
- Do not contractually prohibit regulated workloads in this release. Instead, publish this Regulated-Use Disclaimer on public Legal and Security pages linked from the public footer and Invitation Activation without a separate checkbox: “Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or similar regulated workloads.”
- Release checks scan product, repository, legal, security, and public materials for unsupported regulated-use claims. Factual descriptions of encryption, MFA, retention, backups, and Audit Events remain permitted.
- Continuous automated monitoring is paired with human support Monday-Friday, 9 a.m.-6 p.m. Eastern, excluding U.S. federal holidays. Best-effort response applies after hours.
- During support hours, acknowledge Critical incidents within 30 minutes, High incidents within two hours, and Normal requests within two business days. Critical and High operator alerts use email.
- Critical flows target WCAG 2.2 AA and receive automated checks plus keyboard and screen-reader acceptance.
- Under representative pilot load and normal broadband, authentication and navigation are usable within p95 2.5 seconds, non-media APIs respond within p95 500 milliseconds, and recording feedback appears within one second after permission.

### Repository, supply chain, and releases

- Make the repository public only after completing the public-source readiness checklist. Public visibility does not create an open-source grant: use an all-rights-reserved proprietary notice and no open-source license.
- Remove tracked temporary provider metadata and other machine-local artifacts before publication. Re-run a full-history secret scan.
- Add a security policy and enable private vulnerability reporting, secret scanning, push protection, dependency alerts, and weekly dependency update pull requests.
- Generate an SBOM and scan runtime container images. Critical or High runtime vulnerabilities block release unless a documented exception names the owner, rationale, mitigations, and expiration.
- Replace the shared unrestricted Supabase runtime credential before launch. Use distinct per-environment principals for the web application, isolated identity broker, worker, Platform Admin control plane, backup writer, backup retention deleter, Peely synchronization, migration/release, and Sentry build/runtime duties.
- The web principal has no OpenRouter or backup authority; the identity principal is limited to invitation and Auth administration; the worker is limited to job, Source Audio, artifact, and transcription duties; backup writing is create-only; retention deletion cannot decrypt or create; Peely can read encrypted backup objects and write its offline copy but cannot decrypt or administer the VPS; migration/release authority is unavailable to runtimes; and Sentry source-map upload authority is build-only.
- No secret is reused across a principal or environment. Each credential has an owner, scope, storage location, revocation procedure, and incident-rotation procedure. Automated database/service contracts prove each principal is denied neighboring sensitive actions. Scheduled quarterly rotation remains deferred, while rotation after suspected exposure is mandatory.
- Production deploys only from commits merged into `main`. Every change uses a pull request, required CI, no force push or branch deletion, and no bypass of required checks. The sole maintainer records self-review in the pull request description; zero external approvals are required for the pilot.
- Create the isolated staging stack in its own Railway project with separate web and private worker services, Supabase project and Storage, OpenRouter key and spending limit, monitoring environment, credentials, and synthetic data only.
- Build a single immutable container image from the accepted `main` commit. Deploy it to staging and promote the exact image digest to production without rebuilding.
- Database releases follow expand-migrate-contract. Record a pre-migration point-in-time recovery timestamp, keep old and new shapes compatible during migration, and remove the old shape only in a later accepted release.
- Manual sign-off covers Invitation Activation, password and MFA recovery, real-audio recording on Chrome desktop for macOS and Windows, processing load and service level, playback and Transcript, every download form, Review and Follow-up, retention deletion, Audit Events, database and Source Audio restore, RLS/Workspace isolation, accessibility, security headers, and status/alert behavior.
- Required browser defenses use a fresh per-request nonce and dynamic rendering. Production script policy permits only nonce-authorized scripts with `strict-dynamic`, no `unsafe-inline`, and no `unsafe-eval`; browser destinations are limited to Cauli and the configured Supabase HTTPS/WebSocket origin, with `blob:` limited to media/workers and `data:` limited to images. OpenRouter remains server-only and Sentry uses the same-origin tunnel.
- Enforce `frame-ancestors 'none'`, object/frame denial, same-origin form targets, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, same-origin opener/resource policies, and a Permissions Policy that allows microphone, display capture, fullscreen, and clipboard-write only to Cauli while denying camera, geolocation, payment, USB, serial, Bluetooth, and unrelated capabilities. HSTS uses one year with `includeSubDomains` after staging proves all Cauli subdomains use HTTPS; browser preload is deferred.
- CSP begins report-only in staging until activation, recording, playback, downloads, and Sentry are free of unexplained violations, then becomes enforced before production promotion. CI verifies exact headers and fails on regression.
- Remove the legacy extension-import entry point from production navigation and deployment documentation. Legacy code may remain archived and unsupported in the repository.

### Human prerequisites and launch gates

- The tracked human production-readiness runbook is the authoritative step-by-step procedure for provider logins, MFA, payments, scoped authorization, physical custody, operator legal approval, real-device testing, recovery drills, region evidence, public-repository conversion, and final release sign-off.
- Phase A of the runbook is completed before production-readiness implementation begins. It establishes the private operator record, dedicated Sentry and AWS accounts, Cloudflare ownership and scoped tokens, isolated Railway and Supabase staging projects, a separate OpenRouter staging key, Netcup and Peely readiness, the offline `age` recovery identity, and a content-free implementation handoff.
- Phase B is completed after implementation but before launch because rendered legal documents, deployed region evidence, real recovery artifacts, the exact staging candidate, and promotion approval do not exist earlier.
- Human work is represented by explicit `ready-for-human` tickets. Agent tickets remain `ready-for-agent` for their implementation scope but retain native blockers for external-account bootstrap, operator legal approval, offline recovery acceptance, infrastructure approval, and manual product/release acceptance.
- Secrets and unredacted evidence remain outside GitHub. GitHub records content-free completion evidence and links to the applicable human gate.

## Testing Decisions

- Tests assert externally visible behavior and durable contracts, not component structure, private helper calls, SQL implementation choices, worker loop internals, or visual styling details. A passing suite must demonstrate that an actor can complete or is correctly prevented from completing a workflow and that durable state, access control, and Audit Events agree with the observed result.
- Use four principal seams because the browser, database authorization boundary, asynchronous worker/backup boundary, and release infrastructure have separate trust and failure domains. Pure domain transformations may keep focused unit tests, but new component-level seams should not substitute for acceptance coverage.

### 1. Playwright user-journey seam

- Extend the existing full-browser tests that already cover authentication, recording, Reviews, and initial setup.
- Run against the local Supabase stack with realistic role and Workspace fixtures.
- Cover the public `cauli.pro` Log in path; authenticated landing-page routing; denial for disabled, unassigned, and wrong-role identities; Invitation Activation; mandatory password creation; role-specific MFA; Recovery Code reset; session locking; legal reacceptance; supported-browser gating; Recording Attestation; mic/tab/both capture behavior; navigation recovery; Incomplete and Degraded states; polling; Call pagination/filter/search; Transcript and media exports; Review assignment and bulk assignment; Required/N/A scoring; immutable Review Revisions; Follow-up resolution and verification; retention visibility; Audit Log filtering/export; offboarding; suspension; and accessible keyboard flows.
- Cover public Legal and Security disclosure, absence of an extra disclaimer acceptance gate, nonce CSP/header behavior, same-origin Sentry tunneling, and browser recording under the exact Permissions Policy.
- Test permissions from the browser using Member Role, Manager, Admin, Former Workspace Member, and Platform Admin actors. Verify both allowed and denied behavior.
- Use real browser media fixtures for deterministic CI and perform separate manual real-audio acceptance on macOS and Windows.

### 2. Supabase database-contract seam

- Extend the existing live database-contract suite that exercises RPCs, RLS, leases, and job behavior against local Supabase.
- Cover one-Workspace-per-person enforcement; active-member pilot cap; invitation and activation transitions; role boundaries; keyed Recovery Code state without plaintext; atomic code consumption; rate-limit state; Retention Policy values and scheduled deletion; complete idempotent deletion; immutable Audit Events; one-year Audit Event lifecycle; Scorecard Version immutability/comparability; Review Assignee uniqueness; optimistic concurrency; Follow-up transitions; offboarding preconditions and anonymization; budget and suspension states; break-glass scope/expiry; kill switches; and backup-manifest/deletion authorization.
- Assert cross-Workspace denial directly for every content-bearing entity and privileged RPC.
- Assert that service and Platform Admin paths have only the minimum intended capabilities and cannot obtain routine content through an overlooked query or Storage policy.
- Run an explicit principal-denial matrix for web, identity, worker, Platform Admin, backup writer, retention deleter, Peely, migration/release, and Sentry duties; the shared unrestricted web/worker runtime credential must be absent.

### 3. Worker and external-service contract seam

- Extend existing processing, transcription, storage, checkpoint, media, and lease tests at the worker service boundary.
- Cover idempotent assembly and retries; concurrent lease behavior; Budget Paused without attempt consumption; automatic resume; Needs Attention exhaustion; five-call representative load; the measured five-minute service-level calculation; content-scrubbed telemetry; asynchronous backup; 15-minute backup target; authenticated encryption and tamper rejection; opaque manifests; append-only writer permissions; retention deletion with the separate identity; checksum verification; restore; and regeneration of media and Transcript from restored Source Audio.
- Cover OpenRouter `zdr: true` and `data_collection: deny` on every request, compliant-endpoint unavailability without privacy fallback, dual KMS/offline wrapping, worker unwrap denial, key versioning, rewrap after rotation, and temporary plaintext cleanup.
- Fake provider responses and time at the service boundary for repeatable CI. Run a separately authorized staging acceptance against real transcription and backup providers before promotion.
- Performance tests report queue time and processing time separately while evaluating the combined user-facing target.

### 4. Release and infrastructure acceptance seam

- Treat the isolated staging stack as the release acceptance boundary.
- Verify the exact image digest, separate Railway-project topology and private workers, approved Cloudflare domains and Access policies, server-authorized login routing, migration compatibility, required health endpoints, public status behavior, alert delivery, security headers, content-scrubbed monitoring, environment and credential separation, container scan/SBOM, and synthetic-data-only staging policy.
- Verify persistent-provider U.S. region evidence, disclosed transient OpenRouter processing, Sentry free-plan settings and canary scrubbing, exact CSP enforcement, unsupported-claim scanning, and the complete production-principal denial matrix.
- Perform scripted browser smoke tests and the documented manual sign-off checklist against staging.
- Before first production use, perform database point-in-time recovery into a new project and encrypted Source Audio recovery from the VPS and Peely copy. Repeat the database and backup restore drill quarterly and retain content-free evidence.
- Promotion must fail closed if required CI, staging acceptance, vulnerability gates, migration evidence, backup freshness, or manual sign-off is missing.

## Out of Scope

- More than ten active production Workspace Members.
- A person belonging to multiple Workspaces.
- Self-service registration, billing, subscriptions, payments, plan management, or customer-controlled budget purchasing.
- CRM, calendar, Slack, meeting-platform, or other third-party business integrations.
- Mobile recording or recording from browsers other than Chrome desktop on macOS and Windows.
- Pause and Resume during recording.
- Recording longer than three hours.
- Non-English Transcript generation or multilingual product support.
- Full-Transcript search.
- Direct Transcript editing. Audited regeneration or annotations may be specified later.
- Per-Call retention exceptions, retain-forever, legal holds, or litigation workflows.
- Processing-completion or Follow-up email notifications to Workspace Members.
- SMS or telephone incident alerts.
- Routine Platform Admin access to Call content.
- A two-Admin approval requirement for privileged Workspace actions.
- A requirement for a second maintainer or mandatory external pull-request approval during the pilot.
- Scheduled quarterly credential rotation. Incident-driven rotation remains required.
- Customer-managed encryption keys.
- Backup of derived MP3, WAV, Transcript, Review, or export artifacts; these are regenerated or restored from primary database state and Source Audio.
- Opening the source under an open-source license, accepting outside contributions, or granting redistribution rights.
- Production support for the legacy CallLog extension or its import workflow.
- Claims of SOC 2, HIPAA, PCI, GDPR, or other certification or regulated-use readiness.
- Contractual prohibition of regulated workloads; the pilot uses an accurate Regulated-Use Disclaimer instead.
- Counsel review or a legal opinion on the pilot documents. The operator-approved legal package remains required and must not be represented as counsel-reviewed.
- General availability, public signup, formal 24/7 human support, or service credits.

## Further Notes

- This spec completes and hardens an existing product. The core Call capture, local durability, processing/checkpointing, playback, English Transcript, Scorecard Version, Review, role, deletion, and administration paths should be preserved and extended rather than replaced wholesale.
- The current production deployment was produced from a feature branch while `main` is behind. Before the next release, merge the known-good changes through the required `main` pull-request path and establish `main` as the sole production source.
- The current Calls implementation has fixed-result limits and the current worker has single-job concurrency; both require measured changes to satisfy the pagination and load requirements.
- The repository is currently private. Public visibility and branch-protection changes are an explicit prelaunch operation and must occur only after the proprietary notice, artifact cleanup, security policy, private reporting, and leak-scan checklist passes.
- The backup provider is the existing shared ARM64 Netcup VPS in Manassas, Virginia. The accepted residual risk is that host-root compromise may destroy the VPS copy but cannot decrypt it; Peely and dual key wrapping provide the additional recovery boundaries.
- Managed wrapping uses a dedicated Cauli AWS account and RSA-4096 KMS key in `us-east-2`; offline wrapping uses a passphrase-encrypted `age` X25519 identity with sealed copies at the operator’s residence and partner’s office safe.
- Production and staging use separate Railway projects in Virginia and separate Supabase projects in `us-east-1`. The operator must create the new Cauli Sentry and AWS accounts before implementation.
- The current web and worker share Supabase’s unrestricted service-role credential, and the web declares an OpenRouter key it does not need. Production readiness requires removing both conditions and proving the replacement principal boundaries.
- Counsel review has been removed from the current scope. The operator remains responsible for approving the legal package and Recording Attestation and for ensuring neither is described as counsel-reviewed.
- The tracked human production-readiness runbook separates tasks that must happen before implementation from tasks that require the implemented release candidate. These are explicit human dependencies rather than implementation details a coding agent may invent.
- “Most Calls should be ready within 5 minutes” is the customer-facing wording; the measurable acceptance definition is at least 95% of Calls no longer than 60 minutes, including queue time, under the demonstrated pilot load.
- Product-complete for this spec means the full manual and automated release acceptance passes for the controlled pilot. It does not mean the out-of-scope general-availability capabilities have been built.

# Cloud relay acceptance

The Cloud relay development QA workflow is dispatched deliberately against an
exact website commit and its HTTPS preview. It refuses production, uses the
development rendezvous, and obtains temporary TURN credentials through each
tool's normal authenticated protocol. The workflow needs no TURN secret in the
QA repository. Deployment credentials remain in the development worker.
Before any browser allocates TURN, the workflow builds those five English
tools from the pinned checkout. The spec compares each deployed rendered tool,
JS graph version, stylesheet and every emitted source module with that build.
A stale preview or mixed deployment fails this gate before pairing begins.

The default run uses Chromium, one worker and no retries. An explicit `all`
selection adds Firefox and Playwright WebKit. A single engine and optional title
filter can isolate a failed case; those partial runs do not count as all-engine
acceptance. CI verifies the exact three relay projects before opening sessions
and provides a local PulseAudio sink for native audio contexts. Those engines run the same native
journeys; a pass is not evidence for a real iPhone, Android device, corporate
policy or OS screen lock. Synthetic canvas and oscillator inputs replace only
permission/device capture, not peer connections, codecs, transport or statistics.

A shared pacing ledger reserves ten introductions per case and allows at most
twenty reservations in a 61-second window, below the development Worker's
thirty-per-minute address limit. It survives a failed test worker, records actual
socket openings, and counts the deliberate pre-start wait separately from the
unchanged functional deadlines. Exceeding a reservation fails the test instead
of hiding repeated reconnects or raising the service's limit.

All five tools must establish selected relay candidate pairs and deliver their
actual content after explicit connection and any host approval. Text also
downloads a 16 KiB binary file; the video tools must decode advancing frames;
voice must deliver packets and audible output while preserving quiet initial
microphones. Oncall additionally checks a wrong password and host mute/unmute.
Stop must close peers, stop owned capture and resist foreground notifications.
The separate TLS/443 text case filters the real issued TURN endpoints to
`turns:` on port 443 and requires native selected-pair TLS statistics. It proves
that route specifically; the ordinary journeys leave server selection unchanged.

Expired credentials and cancellation deliberately alter only a credential
response while authentication still uses the development service. Expiry is
relative to the current test time. These refusal cases cannot establish a
connection and do not count as successful live TURN evidence. A mismatched
Direct invitation must be refused without requesting relay credentials.
Ordinary browser coverage also retains Direct as the initial choice, selection
without capture/connection, and Direct failure without an automatic relay retry.

Each relay test saves only allowlisted states, candidate types, traffic counts
and media counters, plus bounded signal-type and SDP-structure counts when
diagnosing admission failures. Raw statistics, SDP, socket addresses, pairing capabilities,
names and TURN credentials are excluded. Socket traces, screenshots and videos
are disabled for this workflow because a trace can contain credential replies.
Sessions end in cleanup even after failure, and the three-day report retention
is deliberate. The ordinary Remote Camera live journey also attaches these
address-free diagnostics on failure so an ICE failure is distinguishable from
approval or video decoding failure.

A green ordinary production report does not imply these optional development
tests ran. Record the dedicated run URL, website SHA, engine results and any
unexecuted cases when assessing launch readiness. Physical-device acceptance
remains separate.

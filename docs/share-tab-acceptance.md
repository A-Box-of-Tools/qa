# Share a Browser Tab acceptance

`tests/tools/share-tab.spec.ts` covers the generated page and its native browser
pairing flow. `lib/share-tab.ts` supplies a moving 640×360 canvas as the browser
picker's result. The stream, video tracks, peer connections, SDP negotiation,
data channels, encoding, RTP, decoding and playback remain native. Advancing
decoded frames, dimensions and inbound RTP bytes establish that video flows;
a visible video element alone does not.

The controlled broker forwards opaque introduction envelopes. It neither
creates SDP nor grants approval. These cases verify:

- Opening an invitation does not capture or connect. Request to watch opens
  only a `tool=share-tab` room; no discovery listing is used.
- The first offer contains a data channel and no media. A request left for
  later stays private. Host approval still cannot attach video while the
  native control channel's approval acknowledgement is deliberately held.
- Releasing that acknowledgement allows one video sender and native moving
  video. The viewer captures nothing, sends no media, receives no audio and
  has no input command path. An unsupported input command closes the peer.
- Four requests can wait; the fifth is refused. Only one viewer is admitted,
  other approval buttons stay disabled, and replacing the admitted viewer
  requires another explicit approval. Denial, Disconnect and host Stop close
  their corresponding attempts.
- Permission denial, picker cancellation, window/screen/unknown-surface
  results and a late picker result after Stop cannot publish an invitation.
  Their acquired tracks are stopped.
- Simulated visibility notifications retain healthy capture. A supplied native
  track's ended event and explicit Stop retire capture and peers; foreground
  notifications never request capture again. Starting again requires a click
  and a fresh invitation.
- A controlled connection failure exposes relay retry without requesting it
  automatically. Clicking retry starts a fresh attempt. An unavailable reply
  fails visibly; supplied dummy credentials demonstrate relay-only viewer
  configuration, not a successful TURN connection or relayed media.

One callback-ordering regression postpones the local open notification until
after a real data-channel message. It masks readyState only during application
listener registration, then uses the native writable channel. Both directions
must send their hello before a response, with no duplicate hello when the
delayed open callback is replayed. This is a deterministic event-order check,
not evidence that a particular physical browser produced that order.

The live-worker case uses actual WebSockets to the endpoint selected by the
checked-out website source, native peers and advancing video. It supports
both an older literal endpoint and the shared production/preview selector,
and checks the actual socket origin against that source contract. It fails
if the deployed worker rejects the
`share-tab` namespace, and checks that the private introduction note stays out
of introduction traffic. Ordinary attempts preserve the tool's declared STUN
configuration and must not request TURN. No actual TURN service is simulated
as successful.

The flowing-video cases run in the Chromium projects. A separate native canvas
probe must succeed there; a tool error never skips a case. The supplied-picker
refusal cases run in every configured engine that can supply the independent
native track, and cancellation/permission/UI cases run in all four projects.
The phone projects emulate viewports, user agents and touch settings. They
are not physical Android or iOS devices. Playwright WebKit is not native
Safari. All native peers in these cases share one runner/browser process, so
the live smoke checks deployment and browser transport without establishing
physical LAN reachability, corporate policies or phone interoperability.

## Physical acceptance before release

Record exact browser/OS versions, host and viewer roles, network topology,
candidate types and whether a relay was explicitly selected. Keep failures in
the record even if changing networks or restarting fixes the next attempt.

1. On a desktop browser, use the real browser picker. Cancel it, refuse it,
   select a window and select a monitor. Only an identified browser tab may
   produce an invitation; refused selections must release their indicators.
   Repeat on native Safari and record unsupported or unidentified capture
   explicitly rather than treating emulated Safari as proof.
2. Share an ordinary test tab with changing content. Connect a separate
   desktop browser and a physical Android/iPhone receiver in turn. Opening
   the link must remain idle; turn away a request and later approve a fresh
   request. Verify live pixels, Play/Full screen, no audio, and no remote
   mouse, keyboard, navigation, text selection or website login/session access.
3. Leave several requests waiting. Approve one, reject another and disconnect
   the approved viewer. Every replacement needs fresh approval; no pending
   viewer may receive a frame while another viewer owns the session.
4. Hide the control page while moving within the selected tab. Exercise
   screen locking, sleep, captured-tab closing, the browser's Stop-sharing
   button, tool Stop, tab closing and Wi-Fi loss. Confirm indicators, tracks
   and remote video end as appropriate. Returning never opens a picker;
   starting again requires a deliberate click and fresh invitation.
5. Check an ordinary direct path separately from an explicitly selected,
   configured real TURN path. Require actual selected relay candidates for
   a TURN claim. Test unavailable credentials and restrictive/corporate or
   isolated networks. A same-runner native pass cannot establish those routes.

Screenshots are not required for this QA-only change: it changes no website
interface. CI runs the tests; no local suite is part of this workflow.

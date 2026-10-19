# Pairing coverage

The five Connect Devices tools use nearby discovery or invitation links and
an online introduction service. They do not offer manual connection blocks,
offline pairing or an Automatic/Online/Offline selector. Installed page-shell
availability remains covered separately by `tests/offline.spec.ts`; a cached
page does not establish that two devices can pair without internet.

`tests/online-pairing.spec.ts` checks the normal page and a retired
`?pairing=offline` URL for every tool on all four browser profiles. Nearby
choices and normal actions remain available, retired controls are absent, and
network hints cannot start capture, create a peer or submit a connection.
The fixture supplies an empty directory; it does not claim that a browser's
online flag proves service availability or local-network reachability.

The existing tool journeys still cover native pairing and its boundaries:

- Share Text: private reader admission, exact text and file bytes, live edits,
  signaling/content separation, recovery and terminal Stop. Separate browser
  processes and Windows Chrome versions exercise the Local network journey.
- Share a Browser Tab: an explicit picker and request, approval and encrypted
  acknowledgement before native video, nearby discovery, candidate filtering,
  single-viewer limits, receive-only controls and terminal Stop.
- Remote Camera: camera/viewer consent, deferred requests, approval and
  acknowledgement before media, native decoded frames and capture cleanup.
- Local Walkie-Talkie: passive channel browsing followed by one-click Join,
  receive-only listeners, initially quiet host capture, explicit talking,
  native audio, recovery and End. Older deployed pages retain coverage for
  their separate Choose and Join controls until that change reaches production.
- Voice Oncall: host naming, deliberate connection and talking, password
  refusal, moderation, quiet recovery and final disconnect/End.

Private discovery checks hover and keyboard explanations on the connection
icons, their borderless appearance, and explicit connection consent. Live
Direct hosts and native Cloud relay journeys verify that a started host shows
its chosen route as a badge and returns to an editable selector after Stop or
End. The badge asserts the selected mode; native relay candidate checks remain
the proof of the route actually used.

`tests/tools/share-tab-network.spec.ts` preserves the connection and capture
intent checks around browser network hints. An introduction-service failure
must remain an explained failure. It cannot offer offline fallback, silently
recapture a tab or restart a stopped session. Share Text's existing recovery
suite separately checks its deliberate retry policy and terminal Stop.

Media fixtures supply canvas/audio tracks only at the physical-device input
boundary. Native peers, descriptions, data channels, media encoding/decoding
and application consent remain in the relevant journeys. Flowing-media cases
run where independent fixture controls establish that the runner can supply
the media; a product timeout is never reclassified as a capability skip.

Phone profiles are emulated viewports, not physical iPhone or Android devices,
and Playwright WebKit is not native Safari. Real local-network permissions,
multicast resolution, corporate restrictions, camera/microphone prompts and
OS lock/unlock still need separate-device validation on normal home Wi-Fi.
Hotspot compatibility is optional for 2.0 and is not claimed by these tests.

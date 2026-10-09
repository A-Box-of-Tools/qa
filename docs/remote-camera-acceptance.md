# Remote Camera acceptance

The spec uses a moving native canvas stream and real Chromium WebRTC between
separate contexts. An opaque local introduction broker makes approval, denial,
competing viewers and teardown repeatable. It checks actual video dimensions
and advancing decoded frames, host/host selected candidates, empty ICE servers,
video-only capture, permissions, cancellation and cleanup. Available lifecycle
checks run in every configured engine. The suite skips the functional spec when
the website checkout has not released the tool yet.

The live-worker smoke check must additionally use an admitted HTTPS preview or
localhost origin. Record real socket negotiation and advancing inbound RTP
frames and bytes; require no video sender before approval, no STUN/TURN, and
no viewer note in signaling. Two isolated browser processes on one machine
check that contract, but do not prove a phone or physical LAN works.

Before release, use a physical Android phone and an iPhone with a desktop:

1. Open the HTTPS tool page on both. Deny camera permission, verify a readable
   error and no pairing invitation, then allow it and start again.
2. Check front/back preference, camera indicator and local preview.
3. Open the QR/link on the viewer. Confirm opening alone neither captures nor
   joins; choose Connect, turn away the request, and confirm no video arrived.
4. Reconnect and approve. Confirm moving video, video-only media and Play/Full
   screen behavior. A second viewer must be refused while the first is active.
5. Disconnect the viewer; confirm the source keeps only local preview. Rejoin
   and approve, then Stop on the source; both camera indicator and viewer end.
6. Repeat with source app switching, screen locking, tab closing, Wi-Fi loss
   and pairing-service loss. No abandoned capture or stale video may continue.
7. Use guest Wi-Fi/client isolation to verify a bounded connection failure and
   no relay fallback. Check OS/browser local-network permission behavior.

Record browser/OS versions, network topology, observed candidate types and
results. Host candidates can follow VPN or public routes, so they do not prove
physical locality. This tool is a browser viewer, not an installed system webcam.

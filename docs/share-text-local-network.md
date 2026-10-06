# Local sharing between two Windows PCs

Use two physical Windows PCs running Google Chrome on the same intended
Wi-Fi or Ethernet LAN. Use synthetic text and files only. Keep the sharer's
tab visible and both PCs awake throughout each connection and transfer.
Leave normal firewall, privacy and browser security settings in place; this
check needs no camera or microphone permission.

CI complements this check with native connections between two browser
processes using bundled Chromium on one host, plus a controlled Local mode
timeout and retry. It cannot certify multicast/mDNS across two PCs, router
isolation, Windows firewall rules or installed Chrome profiles and policies.

## Record the environment first

| Field | PC A | PC B |
|---|---|---|
| Exact Chrome version and channel | | |
| Windows version | | |
| Initial role | Sharer | Reader |
| LAN connection | Wi-Fi/Ethernet; guest network, VPN or managed network if applicable | |
| Website origin and revision/preview commit | | |

Record the date/time and whether either browser has a pending update. Use the
same website origin on both PCs. Keep the revision fixed during recovery if
possible; otherwise record the change. Label PCs A/B rather than publishing
hostnames, local addresses or identifying network details.

On the first sharer, create a small synthetic binary fixture and record its
length and SHA-256:

```powershell
$qaBytes = [byte[]]::new(131072)
for ($qaIndex = 0; $qaIndex -lt $qaBytes.Length; $qaIndex++) {
    $qaBytes[$qaIndex] = ($qaIndex * 73 + 19) % 251
}
[IO.File]::WriteAllBytes('qa-local-share.bin', $qaBytes)
(Get-Item -LiteralPath 'qa-local-share.bin').Length
Get-FileHash -Algorithm SHA256 -LiteralPath 'qa-local-share.bin'
```

## Run and record each stage

In the sharer's editor, write a distinctive synthetic message and attach
`qa-local-share.bin`. Run first with A sharing to B, then with B sharing to A,
using a fresh synthetic name. Mark each direction **Pass**, **Fail** or
**Not run**, with brief physical-device evidence. A successful Connect alone
does not pass approval or file transfer.

| Stage | Action and expected result | A to B / evidence | B to A / evidence |
|---|---|---|---|
| Discovery | On the sharer, open `/share-text/`, select Local network, leave Private and Discoverable on, enter a unique synthetic name and start sharing. The sharer shows Sharing and hides its discovery panel. On the reader's start page, the name appears. | | |
| Transport | On the reader, open that entry or the copied `?local=1` link. Before Connect, no content is shown. Click Connect once; the direct connection reaches the private approval stage without a relay. | | |
| Admission | Enter a synthetic QA note on the reader and choose Ask to read. The sharer sees the request. The reader cannot read the synthetic text or download the attached fixture before approval. Approve on the sharer; the reader receives the exact text and file entry. | | |
| Content | Download the fixture on the reader. Its actual length is 131072 bytes and its SHA-256 equals the sharer's. Use the actual downloaded filename if Chrome adds a suffix. | | |
| Live update | Replace the sharer's text with a second distinctive synthetic message. The reader receives the exact new message while the share stays open. | | |
| Reader relaunch | Keep the sharer sharing. Close Chrome on the reader, relaunch it, and open the current link in a fresh tab. Click Connect and complete Private approval again; verify text and download checksum again. | | |
| Stop | Stop sharing. The reader's open share clears its content and file entries; the sharer returns to editing and discovery. Refresh the reader's discovery page: the name is absent. Files already downloaded remain on the reader. | | |

On the reader, check the downloaded file with:

```powershell
(Get-Item -LiteralPath 'PATH-TO-DOWNLOADED-FILE').Length
Get-FileHash -Algorithm SHA256 -LiteralPath 'PATH-TO-DOWNLOADED-FILE'
```

If discovery fails, try the copied link and record both outcomes separately.
A missing directory entry does not establish a transport failure. If Connect
fails, mark admission/content checks Not run; if approval fails, do not claim
that the file transfer was exercised.

## Capture failure before recovery

Record both exact versions, the failing stage, elapsed time, visible messages
and whether the sharer received a private request. Where available, record
address-free diagnostics: peer/ICE state, host and mDNS candidate counts,
candidate acceptance errors, and whether any candidate pair was selected.
Do not publish full SDP, candidate addresses, profile paths or session tokens.

1. Retry with a fresh reader tab and explicit Connect, keeping the host visible
   and awake. Record the result before changing either browser.
2. Where practical, restart the affected browser at its current version and
   retry separately. If a pending update installs during restart, record that
   restart and update were combined rather than calling it a restart-only test.
3. Update Chrome and relaunch it, recording the resulting exact version on
   each PC. Retry from a fresh Connect. Repeat the approval, text, checksum,
   live update and Stop checks before marking the complete journey Pass.
4. Record which actions were performed and which branches were Not run.
   Matching Chrome versions are not a requirement. Recovery after update and
   relaunch does not establish which action, version change or profile/network
   state caused it.

The motivating report had matching mDNS candidates accepted but no usable ICE
pair. Updating and relaunching Chrome from **153.0.8010.53** to
**154.0.8037.98** was followed by a resolved **Connect** attempt. The original
report did not establish a complete file-transfer pass or a version-specific
cause; those remain distinct evidence to collect with this checklist.
